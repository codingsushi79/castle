import { Button, Text } from "@mantine/core";
import { Component, ReactNode } from "react";
import { reportError, reportsOn } from "../lib/errors";

/** Keeps one broken page from taking down Castle, and reports it if the player allows. */
export class ErrorBoundary extends Component<{ page: string; children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { reportError(error, this.props.page); }
  componentDidUpdate(prev: { page: string }) { if (prev.page !== this.props.page && this.state.error) this.setState({ error: undefined }); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 32, maxWidth: 520 }}>
        <Text fw={800} size="lg">Something went wrong on this page</Text>
        <Text size="sm" c="dimmed" mt={6}>{this.state.error.message}</Text>
        <Text size="sm" mt={6}>{reportsOn() ? "A report was sent, so it can be fixed." : "Turning on error reports in Settings helps get problems like this fixed."}</Text>
        <Button mt="md" onClick={() => this.setState({ error: undefined })}>Try again</Button>
      </div>
    );
  }
}
