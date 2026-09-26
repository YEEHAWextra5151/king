/*
 * The entry chunk is deliberately tiny: it starts the render worker, applies
 * the theme to <html> before first paint, and only then loads the app, so
 * the worker boots in parallel with React instead of after it.
 */
import "./render/prestart";
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles/chrome.css";
import "./styles/document.css";
import "./styles/code.css";
import "./styles/print.css";
import { applyChromeMetrics, applySettings, boot } from "./boot";

applyChromeMetrics();
applySettings(boot.settings, boot.customThemeCss);

if (boot.kind === "settings") void import("./settings/start");
else void import("./app/start");
