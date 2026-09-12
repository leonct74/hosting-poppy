import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./poppy.css"; // the design kit's token sheet — must load before our own styles
import "./theme.css"; // the component layer, built from those tokens (accent: #c9b8e8)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
