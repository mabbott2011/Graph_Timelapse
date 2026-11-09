// Minimal stand-ins for the parts of the Obsidian API the tested modules import.
export const normalizePath = (p: string): string => p.replace(/\\/g, "/").replace(/\/+/g, "/");
export class MarkdownRenderChild {}
export type App = unknown;
export class Modal {}
export class Notice {}
export class Setting {}
export class PluginSettingTab {}
