/**
 * "Export CSV" button for a Call Consumption widget. It downloads the CSV the server builds from the SAME function the
 * screen uses, so the file and the table can't disagree. Disabled when there is nothing to export (`disabled`) and
 * while a download is running; a server refusal is shown as a toast.
 */
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import { filterParams, type CCFilters } from "@/lib/callConsumption";

export function ExportButton({
  path,
  filename,
  applied,
  disabled,
}: {
  path: string;
  filename: string;
  applied: CCFilters;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const { error } = await api.downloadCallConsumption(path, filterParams(applied), filename);
    setBusy(false);
    if (error) toast.error(error);
  };
  return (
    <Button type="button" variant="outline" size="sm" onClick={run} disabled={disabled || busy}>
      {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
      Export CSV
    </Button>
  );
}
