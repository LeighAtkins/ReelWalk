import React from "react";
import { Toolbar } from "./components/Toolbar";
import { PreviewPanel } from "./components/PreviewPanel";
import { Timeline } from "./components/Timeline";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { useEditorStore } from "./store";

export const App: React.FC = () => {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const clipSelected = selectedClipId !== null;

  return (
    <>
      <div className="editor-layout">
        <Toolbar />
        <div className={`editor-main ${clipSelected ? "clip-selected" : ""}`}>
          <div className="editor-view">
            <PreviewPanel />
            <Timeline />
          </div>
          <div className="editor-props">
            <PropertiesPanel />
          </div>
        </div>
      </div>
      <style>{`
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body, #root { height: 100%; overflow: hidden; }
        body {
          font-family: system-ui, -apple-system, sans-serif;
          background: #0a0a14;
          color: #e0e0e0;
        }
        .editor-layout {
          display: flex;
          flex-direction: column;
          height: 100vh;
        }
        .editor-main {
          flex: 1;
          display: flex;
          min-height: 0;
        }
        .editor-view {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 0;
        }
        .editor-props {
          flex-shrink: 0;
        }

        /* Desktop: props as right sidebar */
        @media (min-width: 769px) {
          .editor-props {
            border-left: 1px solid #2a2a4a;
          }
        }

        /* Mobile: full-screen panel swap. No sheets, no transforms. */
        @media (max-width: 768px) {
          .editor-view { flex: 1; }
          .editor-props { display: none; }

          .clip-selected .editor-view { display: none; }
          .clip-selected .editor-props {
            display: flex;
            flex: 1;
            background: #0d0d1a;
          }
        }
      `}</style>
    </>
  );
};
