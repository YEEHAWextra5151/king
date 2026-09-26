import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DocumentWindow } from "./DocumentWindow";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DocumentWindow />
  </StrictMode>,
);
