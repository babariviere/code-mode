# AgentOS host

Adapters expose only restricted virtual workspace, evidence, web, and disposable sandbox bindings.

Bindings are callbacks supplied by the AgentOS host, not an AgentOS SDK implementation. The
adapter rejects workspace escapes, credential-like environment variables, oversized content,
oversized argv, and sandbox timeouts above its configured bound. A deployment must still provide
the isolated virtual filesystem and disposable sandbox behind these callbacks.
