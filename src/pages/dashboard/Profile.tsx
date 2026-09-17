import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Loader2, UserPlus, X, Shield, Trash2 } from "lucide-react";

type TeamMember = {
  id: string;
  member_email: string;
  status: string;
  created_at: string;
};

type MyRole = {
  is_owner: boolean;
};

const Profile = () => {
  const { user } = useAuth();
  const [fullName, setFullName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [myRole, setMyRole] = useState<MyRole | null>(null);

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);

  const fetchData = async () => {
    const [profileRes, teamRes, roleRes] = await Promise.all([
      api.getProfile(),
      api.getTeam(),
      api.getMyRole(),
    ]);
    if (profileRes.data) {
      setFullName(profileRes.data.full_name ?? "");
      setCompanyName(profileRes.data.company_name ?? "");
      setPhone(profileRes.data.phone ?? "");
    }
    if (Array.isArray(teamRes.data)) setTeam(teamRes.data);
    if (roleRes.data) setMyRole(roleRes.data);
    setLoading(false);
  };

  useEffect(() => {
    if (!user) return;
    fetchData();
  }, [user]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    const { error } = await api.updateProfile({
      full_name: fullName,
      company_name: companyName,
      phone,
    });
    setSaving(false);
    if (error) return toast.error(error);
    toast.success("Profile saved");
  };

  const handleInvite = async () => {
    if (!inviteEmail) return toast.error("Enter an email");
    setInviting(true);
    const { data, error } = await api.inviteTeamMember({
      member_email: inviteEmail,
    });
    setInviting(false);
    if (error) return toast.error(error);
    toast.success(
      data?.email_sent
        ? `Invite email sent to ${inviteEmail}`
        : `${inviteEmail} added, but the invite email couldn't be sent — share the accept-invite link with them manually.`
    );
    setInviteEmail("");
    setShowInvite(false);
    fetchData();
  };

  const handleRemove = async (id: string) => {
    if (!confirm("Remove this team member?")) return;
    const { error } = await api.removeTeamMember(id);
    if (error) return toast.error(error);
    toast.success("Member removed");
    fetchData();
  };

  const isOwner = myRole?.is_owner ?? true;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Profile & Teams</h1>
        <p className="text-sm text-muted-foreground">Manage your account and invite collaborators.</p>
      </div>

      {/* Role Badge */}
      {myRole && (
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Your role:</span>
          <Badge variant={isOwner ? "default" : "secondary"} className="capitalize">
            {isOwner ? "Account Owner" : "Team Member"}
          </Badge>
        </div>
      )}

      {/* Profile Form */}
      <section className="rounded-xl border border-border bg-card p-6">
        <h2 className="mb-4 font-semibold text-foreground">Your profile</h2>
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : (
          <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Full name</Label>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={user?.email ?? ""} disabled />
            </div>
            <div className="space-y-1.5">
              <Label>Company</Label>
              <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="sm:col-span-2 flex justify-end">
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save changes
              </Button>
            </div>
          </form>
        )}
      </section>

      {/* Team Members */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold text-foreground">Team Members</h2>
          {isOwner && (
            <Button variant="outline" onClick={() => setShowInvite(!showInvite)}>
              {showInvite ? <X className="mr-2 h-4 w-4" /> : <UserPlus className="mr-2 h-4 w-4" />}
              {showInvite ? "Cancel" : "Add Collaborator"}
            </Button>
          )}
        </div>

        {/* Invite Form */}
        {showInvite && isOwner && (
          <div className="mb-4 rounded-xl border border-border bg-card p-5 space-y-4">
            <h3 className="text-sm font-semibold text-foreground">Invite a Collaborator</h3>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input
                type="email"
                placeholder="colleague@company.com"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
              />
            </div>
            <div className="flex justify-end">
              <Button onClick={handleInvite} disabled={inviting}>
                {inviting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send Invite
              </Button>
            </div>
          </div>
        )}

        {/* Members Table */}
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Status</th>
                {isOwner && <th className="px-4 py-3"></th>}
              </tr>
            </thead>
            <tbody>
              {team.map((m) => (
                <tr key={m.id} className="border-t border-border bg-card/30">
                  <td className="px-4 py-3 font-medium text-foreground">{m.member_email}</td>
                  <td className="px-4 py-3">
                    <Badge variant={m.status === "Active" ? "default" : "secondary"}>{m.status}</Badge>
                  </td>
                  {isOwner && (
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleRemove(m.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
              {team.length === 0 && !loading && (
                <tr>
                  <td colSpan={isOwner ? 3 : 2} className="px-4 py-8 text-center text-muted-foreground">
                    No team members yet. {isOwner && "Click \"Add Collaborator\" to invite someone."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {!isOwner && (
          <p className="mt-3 text-xs text-muted-foreground">
            You are a team member. Only account owners can invite or remove collaborators.
            Sub-users cannot delete any resources.
          </p>
        )}
      </section>
    </div>
  );
};

export default Profile;
