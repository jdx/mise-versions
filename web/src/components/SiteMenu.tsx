import { useEffect, useRef } from "preact/hooks";
import { AuthButton } from "./AuthButton";
import { AdminButton } from "./AdminButton";

export function SiteMenu() {
  const root = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);

  useEffect(() => {
    const dismissOutside = (event: Event) => {
      if (
        root.current &&
        event.target instanceof Node &&
        !root.current.contains(event.target)
      ) {
        root.current.open = false;
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, []);

  const links = () => [
    ...(root.current?.querySelectorAll<HTMLAnchorElement>(
      ".site-menu-panel a[href]",
    ) ?? []),
  ];
  return (
    <details
      class="site-menu"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && root.current?.open) {
          event.preventDefault();
          event.stopPropagation();
          if (root.current) root.current.open = false;
          trigger.current?.focus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!root.current?.open) {
            if (root.current) root.current.open = true;
            requestAnimationFrame(() =>
              (event.key === "ArrowUp" ? links().at(-1) : links()[0])?.focus(),
            );
          } else {
            const items = links();
            const index = items.indexOf(
              document.activeElement as HTMLAnchorElement,
            );
            const next =
              event.key === "ArrowDown"
                ? (index + 1) % items.length
                : (index <= 0 ? items.length : index) - 1;
            items[next]?.focus();
          }
        }
      }}
    >
      <summary
        ref={trigger}
        class="site-menu-trigger"
        aria-label="More resources and account"
        aria-controls="site-menu-panel"
      >
        More{" "}
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m4 6 4 4 4-4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </summary>
      <div
        id="site-menu-panel"
        class="site-menu-panel"
        onClick={(event) => {
          if (
            root.current &&
            event.target instanceof Element &&
            event.target.closest("a")
          ) {
            root.current.open = false;
          }
        }}
      >
        <nav aria-label="Resources">
          <a class="site-menu-item" href="https://mise.jdx.dev">
            <span>Documentation</span>
            <span class="site-menu-external" aria-hidden="true">
              ↗
            </span>
          </a>
          <a class="site-menu-item" href="https://github.com/jdx/mise">
            <span>mise on GitHub</span>
            <span class="site-menu-external" aria-hidden="true">
              ↗
            </span>
          </a>
          <a class="site-menu-item" href="https://github.com/jdx/mise-versions">
            <span>Site source</span>
            <span class="site-menu-external" aria-hidden="true">
              ↗
            </span>
          </a>
        </nav>
        <div class="site-menu-account">
          <AdminButton />
          <AuthButton />
        </div>
      </div>
    </details>
  );
}
