// src/main.js
var COMMAND_ID = "qing.hello-headless.run";
function timestamp() {
  const now = /* @__PURE__ */ new Date();
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}${sign}${hours}:${minutes}`;
}
qing.commands.register(COMMAND_ID, async () => {
  const value = timestamp();
  await qing.clipboard.write(value);
  qing.ui.toast(`\u5DF2\u590D\u5236 ${value}`, "success");
});
qing.on("activate", () => {
  qing.log("hello-headless activated", qing.plugin.version);
});
