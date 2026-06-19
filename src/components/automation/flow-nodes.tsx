import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import {
  Calendar,
  Play,
  PhoneIncoming,
  Globe,
  Split,
  Clock,
  GitBranch,
  Webhook,
  Phone,
  PhoneCall,
  MessageSquare,
  Mail,
  UserCog,
  type LucideIcon,
} from "lucide-react";

export type FlowNodeKind =
  | "event"
  | "now"
  | "inbound-call"
  | "internet-call"
  | "split"
  | "delay"
  | "condition"
  | "webhook"
  | "call"
  | "connect-agent"
  | "sms"
  | "email"
  | "update-contact";

export type FlowNodeData = {
  label: string;
  kind: FlowNodeKind;
  config?: Record<string, unknown>;
};

type Palette = {
  bg: string;
  border: string;
  iconBg: string;
  iconColor: string;
  group: "Trigger" | "Operator" | "Action" | "Condition";
  icon: LucideIcon;
};

const PALETTES: Record<FlowNodeKind, Palette> = {
  event: { bg: "bg-emerald-500/10", border: "border-emerald-500", iconBg: "bg-emerald-500/20", iconColor: "text-emerald-400", group: "Trigger", icon: Calendar },
  now: { bg: "bg-emerald-500/10", border: "border-emerald-500", iconBg: "bg-emerald-500/20", iconColor: "text-emerald-400", group: "Trigger", icon: Play },
  "inbound-call": { bg: "bg-emerald-500/10", border: "border-emerald-500", iconBg: "bg-emerald-500/20", iconColor: "text-emerald-400", group: "Trigger", icon: PhoneIncoming },
  "internet-call": { bg: "bg-emerald-500/10", border: "border-emerald-500", iconBg: "bg-emerald-500/20", iconColor: "text-emerald-400", group: "Trigger", icon: Globe },
  split: { bg: "bg-amber-500/10", border: "border-amber-500", iconBg: "bg-amber-500/20", iconColor: "text-amber-400", group: "Operator", icon: Split },
  delay: { bg: "bg-amber-500/10", border: "border-amber-500", iconBg: "bg-amber-500/20", iconColor: "text-amber-400", group: "Operator", icon: Clock },
  condition: { bg: "bg-amber-500/10", border: "border-amber-500", iconBg: "bg-amber-500/20", iconColor: "text-amber-400", group: "Condition", icon: GitBranch },
  webhook: { bg: "bg-blue-500/10", border: "border-blue-500", iconBg: "bg-blue-500/20", iconColor: "text-blue-400", group: "Action", icon: Webhook },
  call: { bg: "bg-blue-500/10", border: "border-blue-500", iconBg: "bg-blue-500/20", iconColor: "text-blue-400", group: "Action", icon: Phone },
  "connect-agent": { bg: "bg-blue-500/10", border: "border-blue-500", iconBg: "bg-blue-500/20", iconColor: "text-blue-400", group: "Action", icon: PhoneCall },
  sms: { bg: "bg-violet-500/10", border: "border-violet-500", iconBg: "bg-violet-500/20", iconColor: "text-violet-400", group: "Action", icon: MessageSquare },
  email: { bg: "bg-blue-500/10", border: "border-blue-500", iconBg: "bg-blue-500/20", iconColor: "text-blue-400", group: "Action", icon: Mail },
  "update-contact": { bg: "bg-emerald-500/10", border: "border-emerald-500", iconBg: "bg-emerald-500/20", iconColor: "text-emerald-400", group: "Action", icon: UserCog },
};

export function paletteFor(kind: FlowNodeKind): Palette {
  return PALETTES[kind];
}

const baseHandle =
  "!h-3.5 !w-3.5 !border-2 !border-background !bg-muted-foreground hover:!bg-emerald-500 hover:!scale-125 transition-all !cursor-crosshair";

function BaseNode({ kind, label, showInput = true, showOutput = true, dual = false }: {
  kind: FlowNodeKind;
  label: string;
  showInput?: boolean;
  showOutput?: boolean;
  dual?: boolean;
}) {
  const p = PALETTES[kind];
  const Icon = p.icon;

  return (
    <div className={`group relative min-w-[180px] rounded-xl border-2 ${p.border} ${p.bg} px-3 py-2.5 shadow-sm backdrop-blur-sm`}>
      {showInput && (
        <Handle
          type="target"
          position={Position.Left}
          className={baseHandle}
          style={{ left: -7 }}
          isConnectable
        />
      )}

      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{p.group}</div>
      <div className="mt-1 flex items-center gap-2">
        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${p.iconBg}`}>
          <Icon className={`h-3.5 w-3.5 ${p.iconColor}`} />
        </div>
        <div className="text-sm font-semibold text-foreground">{label}</div>
      </div>

      {dual ? (
        <div className="mt-3 space-y-1.5">
          <div className="relative flex items-center justify-end pr-2 text-[10px] font-semibold text-emerald-400">
            <span>Yes</span>
            <Handle
              id="yes"
              type="source"
              position={Position.Right}
              className="!h-3.5 !w-3.5 !border-2 !border-background !bg-emerald-500 hover:!scale-125 transition-all !cursor-crosshair"
              style={{ right: -7, top: "50%", position: "absolute" }}
              isConnectable
            />
          </div>
          <div className="relative flex items-center justify-end pr-2 text-[10px] font-semibold text-rose-400">
            <span>No</span>
            <Handle
              id="no"
              type="source"
              position={Position.Right}
              className="!h-3.5 !w-3.5 !border-2 !border-background !bg-rose-500 hover:!scale-125 transition-all !cursor-crosshair"
              style={{ right: -7, top: "50%", position: "absolute" }}
              isConnectable
            />
          </div>
        </div>
      ) : (
        showOutput && (
          <Handle
            type="source"
            position={Position.Right}
            className={baseHandle}
            style={{ right: -7 }}
            isConnectable
          />
        )
      )}
    </div>
  );
}

function makeNode(opts: { showInput?: boolean; showOutput?: boolean; dual?: boolean } = {}) {
  const C = ({ data }: NodeProps<FlowNodeData>) => (
    <BaseNode kind={data.kind} label={data.label} {...opts} />
  );
  return memo(C);
}

export const TriggerNode = makeNode({ showInput: false });
export const ActionNode = makeNode();
export const OperatorNode = makeNode();
export const ConditionNode = makeNode({ dual: true });

export const NODE_TYPES = {
  trigger: TriggerNode,
  action: ActionNode,
  operator: OperatorNode,
  condition: ConditionNode,
};

export function reactFlowTypeFor(kind: FlowNodeKind): keyof typeof NODE_TYPES {
  if (kind === "condition") return "condition";
  if (PALETTES[kind].group === "Trigger") return "trigger";
  if (PALETTES[kind].group === "Operator") return "operator";
  return "action";
}

export const PALETTE_GROUPS: { title: string; items: { kind: FlowNodeKind; label: string }[] }[] = [
  {
    title: "Triggers",
    items: [
      { kind: "event", label: "Event" },
      { kind: "now", label: "Now" },
      { kind: "inbound-call", label: "Inbound Call" },
      { kind: "internet-call", label: "Internet Call" },
    ],
  },
  {
    title: "Operators",
    items: [
      { kind: "split", label: "Split" },
      { kind: "delay", label: "Delay" },
      { kind: "condition", label: "Condition" },
    ],
  },
  {
    title: "Actions",
    items: [
      { kind: "webhook", label: "Webhook" },
      { kind: "call", label: "Call" },
      { kind: "connect-agent", label: "Connect Call Agent" },
      { kind: "sms", label: "SMS" },
      { kind: "email", label: "Email" },
      { kind: "update-contact", label: "Update Contact" },
    ],
  },
];
