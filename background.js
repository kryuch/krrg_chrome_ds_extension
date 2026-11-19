importScripts("config.js");


const TASK_POLL_ALARM = "krrg-task-poll";
const MIN_ALARM_MINUTES = 1; // жёсткое ограничение chrome.alarms
const DEFAULT_INTERVAL_SECONDS = 60;
const RESPONSE_STABLE_MS = 1500;       // сколько мс текст ответа не должен меняться, чтобы считать его законченным
const RESPONSE_TIMEOUT_MS = 6 * 60 * 1000; // общий таймаут ожидания ответа DeepSeek (поисковые ответы бывают долгими)


// Пока сервис-воркер жив, эта переменная защищает от повторного запуска
// задачи, если предыдущая ещё не завершилась к моменту следующего тика.
let isTaskInProgress = false;


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    handleMessage(message).then(sendResponse);

    return true; // ответ асинхронный
});


chrome.alarms.onAlarm.addListener((alarm) => {

    if (alarm.name === TASK_POLL_ALARM) {
        pollOnce().catch((error) =>
            console.error("KRRG background: poll cycle failed", error));
    }
});


async function handleMessage(message) {

    switch (message && message.type) {

        case "GET_STATUS": {

            const { isRunning, secondsInterval, groupId } =
                await chrome.storage.local.get(["isRunning", "secondsInterval", "groupId"]);

            return {
                isRunning: Boolean(isRunning),
                settings: isRunning ? { secondsInterval, groupId } : null
            };
        }

        case "START_PROCESSING":
            return startProcessing();

        case "STOP_PROCESSING":
            return stopProcessing();

        default:
            return { success: false, error: "UNKNOWN_MESSAGE" };
    }
}


async function startProcessing() {

    const { apiToken } = await chrome.storage.local.get("apiToken");

    if (!apiToken) {
        return { success: false, error: "NOT_AUTHENTICATED" };
    }

    let settings;

    try {
        // /settings теперь POST и сам назначает groupId для этой сессии
        settings = await apiPostJson(apiToken, "/api/deepseek/settings", null);
    } catch (error) {
        console.error("KRRG background: failed to fetch settings", error);
        return { success: false, error: "SETTINGS_FETCH_FAILED" };
    }

    const secondsInterval =
        Number(settings && settings.secondsInterval) || DEFAULT_INTERVAL_SECONDS;
    const groupId = settings && settings.groupId;

    if (groupId === undefined || groupId === null) {
        console.error("KRRG background: settings response has no groupId", settings);
        return { success: false, error: "SETTINGS_FETCH_FAILED" };
    }

    await chrome.storage.local.set({ isRunning: true, secondsInterval, groupId });

    const periodInMinutes = Math.max(secondsInterval / 60, MIN_ALARM_MINUTES);

    chrome.alarms.create(TASK_POLL_ALARM, {
        when: Date.now() + 100, // первый тик почти сразу, не ждём полный период
        periodInMinutes
    });

    return { success: true, settings: { secondsInterval, groupId } };
}


async function stopProcessing() {

    await chrome.alarms.clear(TASK_POLL_ALARM);

    await chrome.storage.local.set({ isRunning: false });

    return { isRunning: false };
}


async function pollOnce() {

    const { apiToken, isRunning, groupId } =
        await chrome.storage.local.get(["apiToken", "isRunning", "groupId"]);

    if (!apiToken || !isRunning || groupId === undefined || groupId === null) {
        await chrome.alarms.clear(TASK_POLL_ALARM);
        return;
    }

    if (isTaskInProgress) {
        // предыдущая задача ещё выполняется — пропускаем этот тик
        return;
    }

    let task;

    try {
        task = await apiGet(
            apiToken,
            `/api/deepseek/task?groupId=${encodeURIComponent(groupId)}`
        );
    } catch (error) {
        console.error("KRRG background: failed to fetch task", error);
        return;
    }

    if (!task || !task.isReady) {
        return;
    }

    isTaskInProgress = true;

    try {

        const answer = await runPromptInDeepSeekTab(task.value);

        await apiPostJson(apiToken, "/api/deepseek/task/result", {
            id: task.id,
            groupId: task.groupId,
            value: answer
        });

    } catch (error) {

        console.error("KRRG background: task processing failed", error);

        // Результат не отправлен — считаем, что задача осталась
        // невыполненной на сервере. Осознанно не шлём частичный/ошибочный
        // ответ в /task/result.

    } finally {
        isTaskInProgress = false;
    }
}


async function runPromptInDeepSeekTab(promptText) {

    const tabs = await chrome.tabs.query({ url: "https://chat.deepseek.com/*" });

    const tab = tabs[0];

    if (!tab) {
        throw new Error("Не найдена открытая вкладка chat.deepseek.com");
    }

    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectedRunPrompt,
        args: [promptText, RESPONSE_STABLE_MS, RESPONSE_TIMEOUT_MS]
    });

    if (result && result.error) {
        throw new Error(result.error);
    }

    return result.answer;
}


// ВАЖНО: эта функция сериализуется и выполняется в контексте самой
// страницы chat.deepseek.com (через chrome.scripting.executeScript),
// поэтому не имеет доступа к переменным/функциям из background.js —
// всё нужное передаётся через args.
//
// Селекторы ниже подобраны по текущей вёрстке chat.deepseek.com
// (на основе публичных userscript'ов для этой страницы) и могут
// сломаться при обновлении сайта. Если перестанет работать —
// проверяйте актуальную структуру страницы через DevTools -> Inspect.
function injectedRunPrompt(promptText, stableMs, timeoutMs) {

    return new Promise((resolve) => {

        try {

            const textarea =
                document.querySelector('textarea[placeholder="Message DeepSeek"]')
                || document.querySelector("textarea");

            if (!textarea) {
                resolve({ error: "Не найдено поле ввода на странице DeepSeek" });
                return;
            }

            // Textarea управляется React'ом: обычное textarea.value = "..."
            // React не заметит. Нужно использовать нативный сеттер
            // value и настоящее Event — стандартный обход для
            // React-controlled полей ввода.
            const nativeValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, "value"
            ).set;

            nativeValueSetter.call(textarea, promptText);
            textarea.dispatchEvent(new Event("input", { bubbles: true }));

            // Кнопка отправки — ищем ближайшую "основную" кнопку в
            // предках textarea.
            function findSendButton() {

                let parent = textarea.parentElement;
                let depth = 0;

                while (parent && depth < 10) {

                    const button =
                        parent.querySelector('div[role="button"].ds-button--primary');

                    if (button && button.offsetParent !== null) {
                        return button;
                    }

                    parent = parent.parentElement;
                    depth += 1;
                }

                return null;
            }

            const sendButton = findSendButton();

            if (!sendButton) {
                resolve({ error: "Не найдена кнопка отправки на странице DeepSeek" });
                return;
            }

            // Точный класс контейнера, который оборачивает ВЕСЬ ответ
            // ассистента целиком (заголовки, абзацы, списки — всё внутри
            // одного элемента). В отличие от подстроки '[class*="markdown"]',
            // это не совпадает попутно с каждым отдельным абзацем/сноской
            // внутри — раньше это и приводило к потере части текста.
            const ANSWER_SELECTOR = ".ds-assistant-message-main-content";

            // Сноски-цитаты (вида "-8") встроены прямо в текст без
            // пробела — вырезаем их перед чтением, иначе они мусором
            // вклиниваются в предложения.
            const CITATION_SELECTOR = ".ds-markdown-cite";

            // Панель кнопок (копировать / regenerate / поделиться) —
            // рендерится ПОСЛЕ полного завершения генерации ответа.
            // Это надёжный сигнал "готово", в отличие от эвристики
            // "текст не менялся N мс", которая может ошибаться на
            // длинных поисковых ответах.
            const DONE_TOOLBAR_SELECTOR = ".ds-button--iconLabelTertiary";
            const MESSAGE_CONTAINER_SELECTOR = ".ds-message";

            function extractCleanText(container) {
                const clone = container.cloneNode(true);
                clone.querySelectorAll(CITATION_SELECTOR).forEach((el) => el.remove());
                return clone.textContent || "";
            }

            function isGenerationDone(answerElement) {
                // Панель кнопок может быть СОСЕДОМ .ds-message, а не его
                // потомком — поднимаемся до общей обёртки виртуализованного
                // списка сообщений (data-virtual-list-item-key), с
                // запасными вариантами на случай других вёрсток.
                const scope =
                    answerElement.closest("[data-virtual-list-item-key]")
                    || answerElement.closest(MESSAGE_CONTAINER_SELECTOR)
                    || answerElement.parentElement
                    || answerElement;
                return Boolean(scope.querySelector(DONE_TOOLBAR_SELECTOR));
            }

            // ВАЖНО: страница использует виртуализированный список
            // сообщений (видны и существуют в DOM только элементы рядом с
            // текущей прокруткой; старые удаляются, DOM-узлы могут
            // переиспользоваться под другие сообщения). Поэтому "количество
            // подходящих элементов выросло" — ненадёжный сигнал: количество
            // видимых элементов может вообще не меняться. Вместо этого
            // запоминаем КОНКРЕТНЫЙ последний узел-ответ (по ссылке) и его
            // текст перед отправкой, а затем ищем узел, который либо явно
            // другой по ссылке, либо тот же узел, но с другим содержимым
            // (переиспользованный DOM-узел).
            const answersBefore = document.querySelectorAll(ANSWER_SELECTOR);
            const previousAnswerElement =
                answersBefore.length > 0 ? answersBefore[answersBefore.length - 1] : null;
            const previousAnswerText =
                previousAnswerElement ? extractCleanText(previousAnswerElement) : null;

            sendButton.click();

            // Ждём появления нового ответа и стабилизации его текста:
            // пока идёт стриминг, текст постоянно меняется; как только
            // он не менялся stableMs миллисекунд подряд — считаем
            // ответ готовым.
            const startedAt = Date.now();
            let lastText = null;
            let lastChangedAt = Date.now();

            const interval = setInterval(() => {

                try {

                    const answers = document.querySelectorAll(ANSWER_SELECTOR);

                    if (answers.length > 0) {

                        const candidate = answers[answers.length - 1];
                        const candidateText = extractCleanText(candidate);

                        const isDifferentNode = candidate !== previousAnswerElement;
                        const isRecycledWithNewContent =
                            !isDifferentNode && candidateText !== previousAnswerText;

                        if (isDifferentNode || isRecycledWithNewContent) {

                            const currentText = candidateText;

                            if (currentText !== lastText) {
                                lastText = currentText;
                                lastChangedAt = Date.now();
                            }

                            // Основной сигнал: появилась панель кнопок —
                            // значит, генерация точно завершена.
                            if (currentText && isGenerationDone(candidate)) {
                                clearInterval(interval);
                                resolve({ answer: currentText });
                                return;
                            }

                            // Резервный сигнал (на случай, если панель
                            // кнопок не нашлась/переименована): текст не
                            // менялся stableMs подряд.
                            if (currentText && Date.now() - lastChangedAt >= stableMs) {
                                clearInterval(interval);
                                resolve({ answer: currentText });
                                return;
                            }
                        }
                    }

                    if (Date.now() - startedAt >= timeoutMs) {
                        clearInterval(interval);
                        resolve({ error: "Таймаут ожидания ответа DeepSeek" });
                    }

                } catch (error) {
                    clearInterval(interval);
                    resolve({ error: "Ошибка при чтении ответа: " + String(error) });
                }

            }, 400);

        } catch (error) {
            resolve({ error: String(error) });
        }
    });
}


async function apiGet(apiToken, path) {

    const response = await fetch(`${API_BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${apiToken}` }
    });

    if (!response.ok) {
        throw new Error(`GET ${path} -> ${response.status}`);
    }

    return response.json();
}


async function apiPostJson(apiToken, path, body) {

    const response = await fetch(`${API_BASE_URL}${path}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json"
        },
        body: body === null || body === undefined ? undefined : JSON.stringify(body)
    });

    if (!response.ok) {
        throw new Error(`POST ${path} -> ${response.status}`);
    }

    const text = await response.text();

    return text ? JSON.parse(text) : null;
}
