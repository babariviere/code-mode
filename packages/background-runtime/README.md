# AgentOS background runtime

Registers only the `code_mode` Pi tool. It has no commands, widgets, or host extension discovery.

The model cannot supply a role policy. The trusted host passes an immutable `rolePolicy` to
`registerBackgroundRuntime`; a binding must enforce the same policy on its host side. The
`generateAgentOsPiPackage` helper emits a manifest and protected environment for an image
builder. It does not install Pi or ACP itself. The generated package pins both integration
dependencies to the selected `0.80.6` version; the image build must verify package availability
and run the ACP smoke tests.
