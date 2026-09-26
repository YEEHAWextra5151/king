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
import { renderClient } from "./render/client";

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
  // Start the render worker now, so its startup overlaps the first IPC.
  renderClient();
  root.render(
    <StrictMode>
      <DocumentWindow />
    </StrictMode>,
  );
}
