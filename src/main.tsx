/**
 * Browser entry point: index.html loads this file as a module script. It mounts <App />
 * into the #root element and pulls in the global Tailwind/theme stylesheet (index.css).
 * Routing, providers and auth setup all live in App.tsx.
 */
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// The non-null assertion is safe because index.html always ships <div id="root">.
createRoot(document.getElementById("root")!).render(<App />);

