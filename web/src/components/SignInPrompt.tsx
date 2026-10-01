import type { ComponentChildren } from "preact";
import { useLoginUrl } from "../hooks/useLoginUrl";
import "../styles/member.css";

interface SignInPromptProps {
  children: ComponentChildren;
  compact?: boolean;
}

// Shown where signed-in-only detail would be. Only text, never real numbers.
export function SignInPrompt({ children, compact }: SignInPromptProps) {
  const href = useLoginUrl();

  return (
    <div class={`signin-prompt${compact ? " signin-prompt-compact" : ""}`}>
      <span>{children}</span>
      <a class="signin-prompt-link" href={href}>
        Sign in with GitHub
      </a>
    </div>
  );
}
