import { create } from "zustand";
import { applySettings, boot } from "../boot";
import type { CustomTheme, Settings } from "../ipc/types";

interface SettingsStore {
  settings: Settings;
  customThemes: CustomTheme[];
  setSettings(settings: Settings): void;
  setCustomThemes(themes: CustomTheme[]): void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: boot.settings,
  customThemes: [],
  setSettings(settings) {
    set({ settings });
    applySettings(settings, activeCustomCss(settings, get().customThemes));
  },
  setCustomThemes(customThemes) {
    set({ customThemes });
    const { settings } = get();
    applySettings(settings, activeCustomCss(settings, customThemes));
  },
}));

function activeCustomCss(settings: Settings, themes: CustomTheme[]): string | null {
  if (!settings.theme.startsWith("custom:")) return null;
  const name = settings.theme.slice("custom:".length);
  return themes.find((t) => t.name === name)?.css ?? boot.customThemeCss ?? "";
}

export const getSettings = () => useSettings.getState().settings;
