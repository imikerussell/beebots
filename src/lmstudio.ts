import type { Config } from "./config.js";
import { SystemOneClient, object } from "./systemone.js";
export { probabilities, validateResponse } from "./systemone.js";
/** LM Studio adds a loaded decision-artifact preflight to the shared typed transport. */
export class LmStudio extends SystemOneClient {
  constructor(opts: Config["local"], fetcher: typeof fetch = fetch) {
    super(
      {
        ...opts,
        label: "Local inference",
        configurationHint:
          "Set LM_STUDIO_MODEL to the actual loaded decision model identifier; check LM Studio/runtime compatibility",
      },
      fetcher,
      {
        preflight: async (signal, fetcher, headers) => {
          // A model unloaded between ticks must not be silently JIT-loaded or replaced.
          const inventoryResponse = await fetcher(
            `${opts.origin}/api/v1/models`,
            { headers, signal: signal },
          );
          if (!inventoryResponse.ok)
            throw new Error(
              `LM Studio model inventory HTTP ${inventoryResponse.status}; cannot verify loaded decision model`,
            );
          const inventory = object(
            await inventoryResponse.json(),
            "model inventory",
          );
          if (!Array.isArray(inventory.models))
            throw new Error("LM Studio /api/v1/models lacks model inventory");
          const loaded = inventory.models
            .map((m) => object(m, "model metadata"))
            .find(
              (m) =>
                Array.isArray(m.loaded_instances) &&
                m.loaded_instances.some(
                  (i) => object(i, "loaded instance").id === opts.model,
                ),
            );
          if (!loaded)
            throw new Error(
              "Configured model is not loaded. Load the Nimble decision GGUF and use its loaded_instances[].id; no automatic loading or fallback.",
            );
          if (loaded.type !== "decision" || loaded.format !== "gguf")
            throw new Error(
              "Loaded artifact is not advertised as a GGUF decision model. Update LM Studio and its llama.cpp runtime, and load a decision-enabled Nimble GGUF; chat/MLX models are not supported by this adapter.",
            );
          return loaded;
        },
      },
    );
  }
}
