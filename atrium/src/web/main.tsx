import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { qc } from "./api";
import { App } from "./App";
import { keepForOffline, registerServiceWorker, watchConnection } from "./phone";
import "./styles.css";

keepForOffline();
registerServiceWorker();
watchConnection();

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={qc}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </QueryClientProvider>,
);
