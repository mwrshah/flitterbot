# Control Surface

The long-running Node.js/TypeScript server that serves as Flitterbot's central nervous system. It hosts multiple concurrent stream agent sessions (one default plus per-stream orchestrators), routes inbound events through a Groq-based classifier, and provides custom tools, skills, and auto-surfaced replies.
