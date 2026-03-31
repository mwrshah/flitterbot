# Message Struct Unification

Unify two divergent message pipelines (WebSocket live events vs. history API) that build chat timeline items through different shapes, different ID conventions, and duplicated frontend construction logic. This eliminates fragile dedup, duplicated message-building code, and the cognitive overhead of maintaining two representations of the same concept.
