// First: start the render worker before the rest of the app is evaluated.
import "./render/prestart";
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles/chrome.css";
import "./styles/document.css";
import "./styles/code.css";
import "./styles/print.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DocumentWindow } from "./app/DocumentWindow";
import { applyChromeMetrics, applySettings, boot } from "./boot";

applyChromeMetrics();
applySettings(boot.settings, boot.customThemeCss);

const root = createRoot(document.getElementById("root")!);

if (boot.kind === "settings") {
  void import("./settings/SettingsApp").then(({ SettingsApp }) =>
    root.render(
      <StrictMode>
        <SettingsApp />
      </StrictMode>,
    ),
  );
} else {
  root.render(
    <StrictMode>
      <DocumentWindow />
    </StrictMode>,
  );
}
