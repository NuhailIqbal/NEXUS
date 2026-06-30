import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import Index from "./pages/Index.tsx";
import Features from "./pages/Features.tsx";
import Technology from "./pages/Technology.tsx";
import Advertisers from "./pages/Advertisers.tsx";
import Publishers from "./pages/Publishers.tsx";
import UseCases from "./pages/UseCases.tsx";
import Pricing from "./pages/Pricing.tsx";
import About from "./pages/About.tsx";
import Login from "./pages/Login.tsx";
import Register from "./pages/Register.tsx";
import ResetPassword from "./pages/ResetPassword.tsx";
import RequestAccess from "./pages/RequestAccess.tsx";
import NotFound from "./pages/NotFound.tsx";

import DashboardLayout from "./pages/dashboard/DashboardLayout.tsx";
import DashboardIndex from "./pages/dashboard/DashboardIndex.tsx";
import QuickSetup from "./pages/dashboard/QuickSetup.tsx";
import AIAgents from "./pages/dashboard/AIAgents.tsx";
import CreateAIAgent from "./pages/dashboard/CreateAIAgent.tsx";
import Tools from "./pages/dashboard/Tools.tsx";
import AIVoices from "./pages/dashboard/AIVoices.tsx";
import VoiceWidgets from "./pages/dashboard/VoiceWidgets.tsx";
import Profile from "./pages/dashboard/Profile.tsx";
import Support from "./pages/dashboard/Support.tsx";
import Conversations from "./pages/dashboard/Conversations.tsx";
import Contacts from "./pages/dashboard/database/Contacts.tsx";
import Lists from "./pages/dashboard/database/Lists.tsx";
import CustomFields from "./pages/dashboard/database/CustomFields.tsx";
import Outbound from "./pages/dashboard/telephony/Outbound.tsx";
import Inbound from "./pages/dashboard/telephony/Inbound.tsx";
import InboundLogs from "./pages/dashboard/telephony/InboundLogs.tsx";
import PhoneNumbers from "./pages/dashboard/telephony/PhoneNumbers.tsx";
import Billing from "./pages/dashboard/Billing.tsx";
import Admin from "./pages/dashboard/Admin.tsx";
import {
  AnalyticsChannel,
  AnalyticsCampaign,
  AnalyticsScenario,
  AnalyticsFlow,
} from "./pages/dashboard/analytics/AnalyticsPages.tsx";


const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/features" element={<Features />} />
            <Route path="/technology" element={<Technology />} />
            <Route path="/advertisers" element={<Advertisers />} />
            <Route path="/publishers" element={<Publishers />} />
            <Route path="/use-cases" element={<UseCases />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/about" element={<About />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/request-access" element={<RequestAccess />} />

            <Route path="/dashboard" element={<DashboardLayout />}>
              <Route index element={<DashboardIndex />} />
              <Route path="quick-setup" element={<QuickSetup />} />
              <Route path="ai-agents" element={<AIAgents />} />
              <Route path="ai-agents/create" element={<CreateAIAgent />} />
              <Route path="tools" element={<Tools />} />
              <Route path="ai-voices" element={<AIVoices />} />
              <Route path="voice-widgets" element={<VoiceWidgets />} />
              <Route path="conversations" element={<Conversations />} />
              <Route path="profile" element={<Profile />} />
              <Route path="support" element={<Support />} />
              <Route path="database/contacts" element={<Contacts />} />
              <Route path="database/lists" element={<Lists />} />
              <Route path="database/custom-fields" element={<CustomFields />} />
              <Route path="telephony/outbound" element={<Outbound />} />
              <Route path="telephony/campaigns" element={<Outbound />} />
              <Route path="telephony/inbound" element={<Inbound />} />
              <Route path="telephony/inbound-logs" element={<InboundLogs />} />
              <Route path="telephony/phone-numbers" element={<PhoneNumbers />} />
              <Route path="analytics/channel" element={<AnalyticsChannel />} />
              <Route path="analytics/campaign" element={<AnalyticsCampaign />} />
              <Route path="analytics/scenario" element={<AnalyticsScenario />} />
              <Route path="analytics/flow" element={<AnalyticsFlow />} />
              <Route path="billing" element={<Billing />} />

            </Route>

            <Route path="/nexus-admin" element={<Admin />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
