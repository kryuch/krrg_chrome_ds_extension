// Единая точка настройки адреса backend'а.
// Подключается как обычный <script> в popup.html и через importScripts
// в background.js — поэтому здесь нет ни export, ни import.
//
// !!! Замените на реальный адрес вашего сервера перед сборкой,
// и не забудьте добавить его в host_permissions в manifest.json.
const API_BASE_URL = "http://localhost:8080";
