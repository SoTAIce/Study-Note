import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles/global.css";

const el = document.getElementById("root");
if (!el) throw new Error("找不到 #root");
createRoot(el).render(<App />);
