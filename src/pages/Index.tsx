import Navbar from "@/components/Navbar";
import HeroSection from "@/components/HeroSection";
import PlatformModules from "@/components/PlatformModules";
import AIWorkforce from "@/components/AIWorkforce";
import DeploymentTimeline from "@/components/DeploymentTimeline";
import LiveOpsCenter from "@/components/LiveOpsCenter";
import PerformanceStats from "@/components/PerformanceStats";
import Comparison from "@/components/Comparison";
import Footer from "@/components/Footer";

const Index = () => (
  <div className="min-h-screen bg-background">
    <Navbar />
    <HeroSection />
    <PlatformModules />
    <AIWorkforce />
    <DeploymentTimeline />
    <LiveOpsCenter />
    <PerformanceStats />
    <Comparison />
    <Footer />
  </div>
);

export default Index;
