class ConnectorError(RuntimeError):
    """A safe, user-facing MCP connector error."""


class CapabilityNotSupported(ConnectorError):
    """Raised when a source does not implement a requested capability."""


class SourceChangedError(ConnectorError):
    """Raised when an upstream source no longer matches its expected structure."""
