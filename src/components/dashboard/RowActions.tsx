/**
 * Icon-only action buttons (view, test, settings, delete) for the last cell of a table row or card.
 * Purely presentational: it only calls the handlers it is given; any confirmation or API call
 * happens in the parent page. Used by Contacts, Lists, PhoneNumbers, Outbound and VoiceWidgets.
 */
import { ReactNode } from "react";
import { PlayCircle, Settings as SettingsIcon, Eye, Trash2 } from "lucide-react";

/** Each button is rendered only when its handler is passed; `extra` is a slot for page-specific controls. */
type Props = {
  onTest?: () => void;
  onSettings?: () => void;
  onView?: () => void;
  onDelete?: () => void;
  extra?: ReactNode;
};

/**
 * Right-aligned row of icon buttons, in the order: `extra`, view, test, settings, delete.
 * The icon-only buttons carry title and aria-label for tooltips and screen readers. On phones
 * they get a fixed 36px square tap target (h-9 w-9), which collapses to a compact padded icon from `sm` up.
 */
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
