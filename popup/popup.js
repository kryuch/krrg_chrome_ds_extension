// API_BASE_URL приходит из config.js, подключённого в popup.html
// раньше этого скрипта — единственное место, где задаётся адрес
// backend'а (общее с background.js).

// Идентификатор клиента для сервера. Пока расширение работает только
// с DeepSeek, значение константно; если появятся другие цели —
// вынести в config.js рядом с API_BASE_URL.
const APPLICATION = "deepseek";


document.addEventListener("DOMContentLoaded", init);


let loginView;
let controlView;
let usernameInput;
let passwordInput;
let loginButton;
let startButton;
let stopButton;
let logoutLink;
let statusElement;


async function init() {

    loginView = document.getElementById("loginView");
    controlView = document.getElementById("controlView");
    usernameInput = document.getElementById("username");
    passwordInput = document.getElementById("password");
    loginButton = document.getElementById("loginButton");
    startButton = document.getElementById("startButton");
    stopButton = document.getElementById("stopButton");
    logoutLink = document.getElementById("logoutLink");
    statusElement = document.getElementById("status");

    loginButton.addEventListener("click", handleLogin);
    startButton.addEventListener("click", handleStart);
    stopButton.addEventListener("click", handleStop);
    logoutLink.addEventListener("click", handleLogout);

    await render();
}


async function render() {

    const { apiToken } =
        await chrome.storage.local.get("apiToken");

    if (!apiToken) {

        loginView.classList.remove("hidden");
        controlView.classList.add("hidden");

        return;
    }

    loginView.classList.add("hidden");
    controlView.classList.remove("hidden");

    const response =
        await chrome.runtime.sendMessage({ type: "GET_STATUS" });

    updateStatus(response && response.isRunning, response && response.settings);
}


function updateStatus(isRunning, settings) {

    let text = isRunning ? "Статус: работает" : "Статус: остановлено";

    if (isRunning && settings && typeof settings.secondsInterval === "number") {
        text += ` (интервал: ${settings.secondsInterval} с`;
        text += settings.groupId !== undefined ? `, сессия: ${settings.groupId})` : ")";
    }

    statusElement.textContent = text;

    startButton.disabled = Boolean(isRunning);
    stopButton.disabled = !isRunning;
}


async function handleLogin() {

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {

        showMessage("Введите логин и пароль");

        return;
    }

    loginButton.disabled = true;
    loginButton.textContent = "Вход...";

    try {

        const response =
            await fetch(`${API_BASE_URL}/api/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password, application: APPLICATION })
            });

        if (!response.ok) {
            throw new Error("Неверный логин или пароль");
        }

        const data = await response.json();

        await chrome.storage.local.set({ apiToken: data.token });

        passwordInput.value = "";

        showMessage("");

        await render();

    } catch (error) {

        console.error(error);

        showMessage(error.message || "Ошибка входа");

    } finally {

        loginButton.disabled = false;
        loginButton.textContent = "Войти";
    }
}


async function handleLogout() {

    const { apiToken } =
        await chrome.storage.local.get("apiToken");

    // Останавливаем обработку и отзываем токен на сервере —
    // best effort, даже если сеть недоступна, всё равно чистим
    // локально.

    try {
        await chrome.runtime.sendMessage({ type: "STOP_PROCESSING" });
    } catch (error) {
        console.log("KRRG popup: failed to stop before logout", error);
    }

    if (apiToken) {

        try {

            await fetch(`${API_BASE_URL}/api/auth/logout`, {
                method: "POST",
                headers: { Authorization: `Bearer ${apiToken}` }
            });

        } catch (error) {
            console.log("KRRG popup: logout request failed", error);
        }
    }

    await chrome.storage.local.remove("apiToken");

    showMessage("");

    await render();
}


async function handleStart() {

    startButton.disabled = true;

    try {

        const response =
            await chrome.runtime.sendMessage({ type: "START_PROCESSING" });

        if (!response || !response.success) {

            if (response && response.error === "NOT_AUTHENTICATED") {

                showMessage("Сессия истекла, войдите заново");

                await chrome.storage.local.remove("apiToken");

                await render();

                return;
            }

            if (response && response.error === "SETTINGS_FETCH_FAILED") {

                showMessage("Не удалось получить настройки с сервера");

                startButton.disabled = false;

                return;
            }

            showMessage("Не удалось запустить");

            startButton.disabled = false;

            return;
        }

        showMessage("");

        updateStatus(true, response.settings);

    } catch (error) {

        console.error(error);

        showMessage("Ошибка: " + error.message);

        startButton.disabled = false;
    }
}


async function handleStop() {

    stopButton.disabled = true;

    try {

        const response =
            await chrome.runtime.sendMessage({ type: "STOP_PROCESSING" });

        showMessage("");

        updateStatus(response && response.isRunning);

    } catch (error) {

        console.error(error);

        showMessage("Ошибка: " + error.message);

        stopButton.disabled = false;
    }
}


function showMessage(message) {

    const element = document.getElementById("message");

    if (element) {
        element.textContent = message;
    }
}
