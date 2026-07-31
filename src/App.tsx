import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { isAdminHost } from "@/lib/adminHost";
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
import VerifyEmail from "./pages/VerifyEmail.tsx";
import ResetPassword from "./pages/ResetPassword.tsx";
import RequestAccess from "./pages/RequestAccess.tsx";
import PrivacyPolicy from "./pages/PrivacyPolicy.tsx";
import NotFound from "./pages/NotFound.tsx";

import DashboardLayout from "./pages/dashboard/DashboardLayout.tsx";
import DashboardIndex from "./pages/dashboard/DashboardIndex.tsx";
import QuickSetup from "./pages/dashboard/QuickSetup.tsx";
import AIAgents from "./pages/dashboard/AIAgents.tsx";
import CreateAIAgent from "./pages/dashboard/CreateAIAgent.tsx";
import AIVoices from "./pages/dashboard/AIVoices.tsx";
import Profile from "./pages/dashboard/Profile.tsx";
import Support from "./pages/dashboard/Support.tsx";
import Conversations from "./pages/dashboard/Conversations.tsx";
import Integrations from "./pages/dashboard/Integrations.tsx";
import Contacts from "./pages/dashboard/database/Contacts.tsx";
import Lists from "./pages/dashboard/database/Lists.tsx";
import Outbound from "./pages/dashboard/telephony/Outbound.tsx";
import Inbound from "./pages/dashboard/telephony/Inbound.tsx";
import InboundLogs from "./pages/dashboard/telephony/InboundLogs.tsx";
import PhoneNumbers from "./pages/dashboard/telephony/PhoneNumbers.tsx";
import BillingLayout from "./components/billing/BillingLayout.tsx";
import BillingOverview from "./components/billing/BillingOverview.tsx";
import PaymentMethods from "./components/billing/PaymentMethods.tsx";
import Promotions from "./components/billing/Promotions.tsx";
import Admin from "./pages/dashboard/Admin.tsx";
import {
  AnalyticsChannel,
  AnalyticsCampaign,
  AnalyticsScenario,
  AnalyticsFlow,
} from "./pages/dashboard/analytics/AnalyticsPages.tsx";


const queryClient = new QueryClient();

const App = () => {
  const adminHost = isAdminHost();

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem storageKey="nexus-theme">
      <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <AuthProvider>
            {adminHost ? (
              // admin.edmnexus.ai serves only the admin portal — it manages its own
              // internal sections via state, not sub-routes, so a single catch-all works.
              <Routes>
                <Route path="*" element={<Admin />} />
              </Routes>
            ) : (
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
                <Route path="/verify-email" element={<VerifyEmail />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/request-access" element={<RequestAccess />} />
                <Route path="/privacy" element={<PrivacyPolicy />} />

                <Route path="/dashboard" element={<DashboardLayout />}>
                  <Route index element={<DashboardIndex />} />
                  <Route path="quick-setup" element={<QuickSetup />} />
                  <Route path="ai-agents" element={<AIAgents />} />
                  <Route path="ai-agents/create" element={<CreateAIAgent />} />
                  <Route path="ai-voices" element={<AIVoices />} />
                  <Route path="conversations" element={<Conversations />} />
                  <Route path="integrations" element={<Integrations />} />
                  <Route path="profile" element={<Profile />} />
                  <Route path="support" element={<Support />} />
                  <Route path="database/contacts" element={<Contacts />} />
                  <Route path="database/lists" element={<Lists />} />
                  <Route path="telephony/outbound" element={<Outbound />} />
                  <Route path="telephony/campaigns" element={<Outbound />} />
                  <Route path="telephony/inbound" element={<Inbound />} />
                  <Route path="telephony/inbound-logs" element={<InboundLogs />} />
                  <Route path="telephony/phone-numbers" element={<PhoneNumbers />} />
                  <Route path="analytics/channel" element={<AnalyticsChannel />} />
                  <Route path="analytics/campaign" element={<AnalyticsCampaign />} />
                  <Route path="analytics/scenario" element={<AnalyticsScenario />} />
                  <Route path="analytics/flow" element={<AnalyticsFlow />} />
                  <Route path="billing" element={<BillingLayout />}>
                    <Route index element={<BillingOverview />} />
                    <Route path="payment-methods" element={<PaymentMethods />} />
                    <Route path="promotions" element={<Promotions />} />
                  </Route>

                </Route>

                <Route path="*" element={<NotFound />} />
              </Routes>
            )}
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
};

export default App;
