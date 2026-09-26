/**
 * Imported first by main.tsx, so the render worker starts downloading and
 * compiling before React and the rest of the app are evaluated.
 */
import { boot } from "../boot";
import { renderClient } from "./client";

if (boot.kind !== "settings") renderClient();
