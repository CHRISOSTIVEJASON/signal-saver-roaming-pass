import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "./ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an unhandled render error:", error, errorInfo);
  }

  private handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  private handleResetCache = () => {
    if (typeof window !== "undefined") {
      try {
        sessionStorage.clear();
      } catch {}
      window.location.reload();
    }
  };

  public override render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
          <div className="w-full max-w-md space-y-4 rounded-2xl border border-destructive/40 bg-card p-6 text-center shadow-lg">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
              <AlertTriangle className="h-8 w-8" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-foreground">Something went wrong</h2>
              <p className="text-xs text-muted-foreground leading-relaxed">
                The application caught a display issue. Your active pass and stamped pool networks remain safe.
              </p>
            </div>
            {this.state.error && (
              <pre className="max-h-24 overflow-auto rounded-lg bg-secondary/60 p-2.5 text-left font-mono text-[11px] text-muted-foreground">
                {this.state.error.message || String(this.state.error)}
              </pre>
            )}
            <div className="grid grid-cols-2 gap-2 pt-2">
              <Button
                onClick={this.handleReload}
                className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-primary text-sm font-semibold text-primary-foreground hover:brightness-110"
              >
                <RefreshCw className="h-4 w-4" /> Reload App
              </Button>
              <Button
                variant="outline"
                onClick={this.handleResetCache}
                className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-border text-xs font-medium hover:bg-secondary"
              >
                <Trash2 className="h-4 w-4" /> Reset View
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
