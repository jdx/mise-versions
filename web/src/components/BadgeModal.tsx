import { useState, useCallback } from "preact/hooks";

interface BadgeModalProps {
  tool: string;
  onClose: () => void;
}

export function BadgeModal({ tool, onClose }: BadgeModalProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const baseUrl = "https://mise-tools.jdx.dev";
  const toolUrl = `${baseUrl}/tools/${tool}`;

  const badges = [
    {
      id: "total",
      label: "Total downloads",
      url: `${baseUrl}/badge/${tool}.svg`,
    },
    {
      id: "30d",
      label: "Last 30 days",
      url: `${baseUrl}/badge/${tool}/30d`,
    },
    {
      id: "week",
      label: "Last 7 days",
      url: `${baseUrl}/badge/${tool}/week`,
    },
  ];

  const copyToClipboard = useCallback(async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, []);

  return (
    <div
      class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="bg-dark-800 border border-dark-600 rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div class="flex items-center justify-between mb-6">
          <h2 class="text-xl font-semibold text-gray-200">Get Badge</h2>
          <button
            onClick={onClose}
            class="text-gray-400 hover:text-gray-200 transition-colors"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p class="text-gray-400 text-sm mb-6">
          Add a download badge to your README to show how many people are using {tool} with mise.
        </p>

        <div class="space-y-6">
          {badges.map((badge) => {
            const markdownSnippet = `[![mise](${badge.url})](${toolUrl})`;
            const htmlSnippet = `<a href="${toolUrl}"><img src="${badge.url}" alt="mise downloads"></a>`;

            return (
              <div key={badge.id} class="border border-dark-600 rounded-lg p-4">
                <div class="flex items-center justify-between mb-3">
                  <span class="text-sm font-medium text-gray-300">{badge.label}</span>
                  <img src={badge.url} alt={badge.label} class="h-5" />
                </div>

                <div class="space-y-3">
                  <div>
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-xs text-gray-500">Markdown</span>
                      <button
                        onClick={() => copyToClipboard(markdownSnippet, `${badge.id}-md`)}
                        class="text-xs text-neon-blue hover:text-neon-purple transition-colors"
                      >
                        {copiedId === `${badge.id}-md` ? "Copied!" : "Copy"}
                      </button>
                    </div>
                    <code class="block bg-dark-700 rounded px-3 py-2 text-xs font-mono text-gray-300 overflow-x-auto">
                      {markdownSnippet}
                    </code>
                  </div>

                  <div>
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-xs text-gray-500">HTML</span>
                      <button
                        onClick={() => copyToClipboard(htmlSnippet, `${badge.id}-html`)}
                        class="text-xs text-neon-blue hover:text-neon-purple transition-colors"
                      >
                        {copiedId === `${badge.id}-html` ? "Copied!" : "Copy"}
                      </button>
                    </div>
                    <code class="block bg-dark-700 rounded px-3 py-2 text-xs font-mono text-gray-300 overflow-x-auto">
                      {htmlSnippet}
                    </code>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
