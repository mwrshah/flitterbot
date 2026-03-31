# TanStack Patterns

Move WebSocket subscription ownership out of route component effects and into TanStack Router primitives. The subscription mode depends on resolved route state (wildcard for `/`, real session ID for the default stream, exact param for specific sessions), making it a router concern rather than a view concern.
