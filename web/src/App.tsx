import { useCallback, useEffect, useState } from "react";
import * as api from "./api";
import Home from "./views/Home";
import Editor from "./views/Editor";
import SettingsView from "./views/Settings";

type View = { screen: "home" } | { screen: "editor"; project: string } | { screen: "settings" };

export interface Notify {
  (message: string, kind?: "info" | "error"): void;
}

export default function App() {
  const [view, setView] = useState<View>({ screen: "home" });
  const [snack, setSnack] = useState<{ message: string; kind: "info" | "error" } | null>(null);

  const notify: Notify = useCallback((message, kind = "info") => {
    setSnack({ message, kind });
  }, []);

  useEffect(() => {
    if (!snack) return;
    const t = setTimeout(() => setSnack(null), 4000);
    return () => clearTimeout(t);
  }, [snack]);

  const openEditor = useCallback((project: string) => {
    setView({ screen: "editor", project });
  }, []);

  return (
    <div className="app">
      {view.screen === "home" && (
        <Home
          onOpen={openEditor}
          onSettings={() => setView({ screen: "settings" })}
          notify={notify}
        />
      )}
      {view.screen === "editor" && (
        <Editor
          project={view.project}
          onHome={() => setView({ screen: "home" })}
          notify={notify}
        />
      )}
      {view.screen === "settings" && (
        <SettingsView onBack={() => setView({ screen: "home" })} />
      )}
      {snack && (
        <div className={`snackbar ${snack.kind === "error" ? "error" : ""}`} role="status">
          {snack.message}
        </div>
      )}
    </div>
  );
}

export { api };
