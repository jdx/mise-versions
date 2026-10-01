import "../styles/member.css";

// Small padlock marking something that needs a GitHub sign-in.
export function LockMark() {
  return (
    <span class="lock-mark" role="img" aria-label="Sign in required">
      <svg
        viewBox="0 0 16 16"
        width="10"
        height="10"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z" />
      </svg>
    </span>
  );
}
