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
          className="flex h-9 w-9 items-center justify-center rounded-md p-0 text-muted-foreground hover:bg-muted hover:text-foreground sm:h-auto sm:w-auto sm:p-1.5"
        >
          <Eye className="h-4 w-4" />
        </button>
      )}
      {onTest && (
        <button
          onClick={onTest}
          title="Test"
          aria-label="Test"
          className="flex h-9 w-9 items-center justify-center rounded-md p-0 text-muted-foreground hover:bg-muted hover:text-primary sm:h-auto sm:w-auto sm:p-1.5"
        >
          <PlayCircle className="h-4 w-4" />
        </button>
      )}
      {onSettings && (
        <button
          onClick={onSettings}
          title="Settings"
          aria-label="Settings"
          className="flex h-9 w-9 items-center justify-center rounded-md p-0 text-muted-foreground hover:bg-muted hover:text-foreground sm:h-auto sm:w-auto sm:p-1.5"
        >
          <SettingsIcon className="h-4 w-4" />
        </button>
      )}
      {onDelete && (
        <button
          onClick={onDelete}
          title="Delete"
          aria-label="Delete"
          className="flex h-9 w-9 items-center justify-center rounded-md p-0 text-muted-foreground hover:bg-muted hover:text-destructive sm:h-auto sm:w-auto sm:p-1.5"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
