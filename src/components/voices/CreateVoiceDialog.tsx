import { useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (voice: {
    name: string;
    file: File;
    language: string;
    accent: string;
    category: string;
    description: string;
  }) => void;
};

export function CreateVoiceDialog({ open, onOpenChange, onCreate }: Props) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState("English");
  const [accent, setAccent] = useState("");
  const [category, setCategory] = useState("General");
  const [description, setDescription] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setName("");
    setFile(null);
    setLanguage("English");
    setAccent("");
    setCategory("General");
    setDescription("");
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleSubmit = () => {
    if (!name.trim()) return toast.error("Voice name is required");
    if (!file) return toast.error("Please upload an audio sample");
    if (!accent) return toast.error("Please select an accent");
    onCreate?.({ name, file, language, accent, category, description });
    toast.success(`Voice "${name}" created`);
    handleClose(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-xl gap-0 p-0 sm:rounded-xl [&>button]:hidden">
        <DialogHeader className="flex-row items-start justify-between space-y-0 border-b border-border p-6">
          <div>
            <DialogTitle className="text-xl">Create New Voice</DialogTitle>
            <DialogDescription className="mt-1">
              Upload audio sample and configure voice settings
            </DialogDescription>
          </div>
          <button
            onClick={() => handleClose(false)}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-5 overflow-y-auto p-6">
          <section className="rounded-lg border border-border bg-muted/30 p-4">
            <h3 className="mb-3 text-sm font-semibold">Basic Information</h3>
            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-sm font-medium">Voice Name</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Professional Sarah" />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Audio Sample</label>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex w-full flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-input bg-background py-6 text-center transition hover:border-primary/50"
                >
                  <Upload className="h-5 w-5 text-primary" />
                  <span className="text-sm font-medium text-primary">
                    {file ? file.name : "Click to upload"}
                  </span>
                  <span className="text-xs text-muted-foreground">MP3, WAV, M4A, OGG, FLAC, MP4, MPEG</span>
                  <span className="text-xs text-muted-foreground">(min 10 sec, max 30MB)</span>
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,audio/ogg,audio/flac,video/mp4"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-muted/30 p-4">
            <h3 className="mb-3 text-sm font-semibold">Voice Configuration</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-sm font-medium">Language</label>
                <select value={language} onChange={(e) => setLanguage(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  <option>English</option>
                  <option>Spanish</option>
                  <option>French</option>
                  <option>German</option>
                  <option>Afrikaans</option>
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Accent</label>
                <select value={accent} onChange={(e) => setAccent(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  <option value="">Select Accent</option>
                  <option>American</option>
                  <option>British</option>
                  <option>Australian</option>
                  <option>South African</option>
                  <option>Indian</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="mb-1.5 block text-sm font-medium">Category</label>
                <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  <option>General</option>
                  <option>Narration</option>
                  <option>Conversational</option>
                  <option>Character</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="mb-1.5 block text-sm font-medium">Description</label>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe this voice…" rows={3} className="w-full rounded-md border border-input bg-background p-2 text-sm" />
              </div>
            </div>
          </section>
        </div>

        <div className="flex justify-between gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={() => handleClose(false)}>Cancel</Button>
          <Button onClick={handleSubmit} className="bg-primary text-primary-foreground hover:opacity-90">Create Voice</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
