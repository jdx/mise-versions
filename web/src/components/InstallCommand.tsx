import { useState } from "preact/hooks";
import { BadgeModal } from "./BadgeModal";
export function InstallCommand({ tool }: { tool: string }) {
  const [badge, setBadge] = useState(false);
  const [status, setStatus] = useState("");
  const command = `mise use ${tool}@latest`;
  return (
    <section class="install-panel" aria-label="Install with mise">
      <div>
        <div class="install-label">Install with mise</div>
        <code>
          <span class="text-gray-500" aria-hidden="true">
            ${" "}
          </span>
          {command}
        </code>
        <span role="status" class="text-xs text-gray-500 block">
          {status}
        </span>
      </div>
      <div class="install-actions">
        <button class="secondary-button" onClick={() => setBadge(true)}>
          Get badge
        </button>
        <button
          class="primary-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(command);
              setStatus("Command copied");
            } catch {
              setStatus(
                "Could not copy. Select the command to copy it manually.",
              );
            }
          }}
        >
          Copy command
        </button>
      </div>
      {badge && <BadgeModal tool={tool} onClose={() => setBadge(false)} />}
    </section>
  );
}
