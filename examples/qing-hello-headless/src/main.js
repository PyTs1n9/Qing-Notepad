/**
 * Example plugin: copy the current timestamp.
 *
 * The build step (`npm run build` here) bundles this file into a single ESM
 * `main.js` at the package root. That is not a style preference: the host loads
 * a plugin through a blob URL, where relative imports cannot be resolved — a
 * package with more than one module simply fails to load.
 */
const COMMAND_ID = "qing.hello-headless.run";

function timestamp() {
  // ISO 8601 with milliseconds, in local time offset form, so the pasted value
  // is unambiguous when it lands in a changelog.
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `.${pad(now.getMilliseconds(), 3)}${sign}${hours}:${minutes}`
  );
}

qing.commands.register(COMMAND_ID, async () => {
  const value = timestamp();
  await qing.clipboard.write(value);
  qing.ui.toast(`已复制 ${value}`, "success");
});

qing.on("activate", () => {
  qing.log("hello-headless activated", qing.plugin.version);
});
