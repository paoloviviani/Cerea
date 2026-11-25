/**
 * What an MCP App page is told about how the chat looks: the standardized style variables
 * (`McpUiStyleVariableKey` in the spec), written with `light-dark()` so one set serves both themes,
 * and the theme itself. Values are the chat's own greys and blue; nothing here comes from the page.
 */
const pair = (light: string, dark: string) => `light-dark(${light}, ${dark})`;

export const MCP_APP_STYLE_VARIABLES: Record<string, string> = {
	"--color-background-primary": pair("#ffffff", "#1f2937"),
	"--color-background-secondary": pair("#f9fafb", "#111827"),
	"--color-background-tertiary": pair("#f3f4f6", "#374151"),
	"--color-background-inverse": pair("#111827", "#f9fafb"),
	"--color-background-info": pair("#eff6ff", "#1e3a8a"),
	"--color-background-danger": pair("#fef2f2", "#7f1d1d"),
	"--color-background-success": pair("#f0fdf4", "#14532d"),
	"--color-background-warning": pair("#fffbeb", "#78350f"),
	"--color-text-primary": pair("#111827", "#f9fafb"),
	"--color-text-secondary": pair("#4b5563", "#d1d5db"),
	"--color-text-tertiary": pair("#6b7280", "#9ca3af"),
	"--color-text-inverse": pair("#f9fafb", "#111827"),
	"--color-text-info": pair("#1d4ed8", "#93c5fd"),
	"--color-text-danger": pair("#b91c1c", "#fca5a5"),
	"--color-text-success": pair("#15803d", "#86efac"),
	"--color-text-warning": pair("#b45309", "#fcd34d"),
	"--color-border-primary": pair("#d1d5db", "#4b5563"),
	"--color-border-secondary": pair("#e5e7eb", "#374151"),
	"--color-ring-primary": pair("#2563eb", "#60a5fa"),
	"--font-sans": "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
	"--font-mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
	"--font-text-sm-size": "0.875rem",
	"--font-text-md-size": "1rem",
	"--border-radius-sm": "0.375rem",
	"--border-radius-md": "0.5rem",
	"--border-radius-lg": "0.75rem",
	"--border-width-regular": "1px",
};
