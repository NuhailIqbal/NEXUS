import { ReactNode } from "react";
import { PlayCircle, Settings as SettingsIcon, Eye, Trash2 } from "lucide-react";

type Props = {
  onTest?: () => void;
  onSettings?: () => void;
  onView?: () => void;
  onDelete?: () => void;
  extra?: ReactNode;
};

export function RowActions({ onTest, onSettings, onView, onDelete, extra }: Props) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      {extra}
      {onView && (
        <button
          onClick={onView}
          title="View"
          aria-label="View"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Eye className="h-4 w-4" />
        </button>
      )}
      {onTest && (
        <button
          onClick={onTest}
          title="Test"
          aria-label="Test"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-primary"
        >
          <PlayCircle className="h-4 w-4" />
        </button>
      )}
      {onSettings && (
        <button
          onClick={onSettings}
          title="Settings"
          aria-label="Settings"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <SettingsIcon className="h-4 w-4" />
        </button>
      )}
      {onDelete && (
        <button
          onClick={onDelete}
          title="Delete"
          aria-label="Delete"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
