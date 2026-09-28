import HeroSection from "@/components/HeroSection";
import PlatformModules from "@/components/PlatformModules";
import AIWorkforce from "@/components/AIWorkforce";
import DeploymentTimeline from "@/components/DeploymentTimeline";
import LiveOpsCenter from "@/components/LiveOpsCenter";
import PerformanceStats from "@/components/PerformanceStats";
import Comparison from "@/components/Comparison";
import { MarketingPage } from "@/components/marketing/MarketingPrimitives";

const Index = () => (
  <MarketingPage>
    <HeroSection />
    <PlatformModules />
    <AIWorkforce />
    <DeploymentTimeline />
    <LiveOpsCenter />
    <PerformanceStats />
    <Comparison />
  </MarketingPage>
);

export default Index;
