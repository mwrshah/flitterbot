# WS Subscription Filtering

WebSocket subscription filtering so that multiple stream agent sessions sharing a single WebSocket connection only receive events they have subscribed to. Clients send subscribe/unsubscribe messages to declare which sessions they care about, and the server filters broadcasts accordingly.
