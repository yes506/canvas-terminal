import { useState, useEffect, useRef } from "react";
import { Palette } from "lucide-react";
import { useTerminalStore } from "../../stores/terminalStore";
import { terminalThemes, themeNames } from "../terminal/themes";

export function ThemeSelector() {
  const { themeName, setTheme } = useTerminalStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        title="Terminal Theme"
        className="text-text-muted hover:text-text p-1"
        onClick={() => setOpen(!open)}
      >
        <Palette size={13} />
      </button>

      {open && (
        <div className="absolute bottom-6 right-0 bg-surface-light border border-surface-lighter rounded-md shadow-lg py-1 min-w-[140px] z-50">
          {themeNames.map((name) => {
            const theme = terminalThemes[name];
            return (
              <button
                key={name}
                className={`w-full px-3 py-1.5 text-left text-xs hover:bg-surface-lighter transition-colors flex items-center gap-2 ${
                  themeName === name ? "text-accent" : "text-text-muted"
                }`}
                onClick={() => {
                  setTheme(name);
                  setOpen(false);
                }}
              >
                <span
                  className="w-3 h-3 rounded-sm border border-surface-lighter"
                  style={{ backgroundColor: theme.background }}
                />
                {name.charAt(0).toUpperCase() + name.slice(1)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
