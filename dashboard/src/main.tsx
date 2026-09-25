import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Setup } from "./Setup";
import "./styles.css";
import { applyProfile, type Profile } from "./types";

async function boot() {
  let profile: Profile | null = null;
  try {
    const r = await fetch("/profile", { cache: "no-store" });
    if (r.ok) profile = (await r.json()) as Profile;
  } catch {
    /* engine not up yet: show the defaults, the feed reconnects on its own */
  }
  if (profile && !profile.setup) applyProfile(profile);
  createRoot(document.getElementById("root")!).render(<StrictMode>{profile?.setup ? <Setup /> : <App />}</StrictMode>);
}

void boot();
