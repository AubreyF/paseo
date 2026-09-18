import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { OpenProjectScreen } from "@/screens/open-project-screen";
import { Redirect } from "expo-router";
import { useHosts } from "@/runtime/host-runtime";
import { useVortonMode } from "@/vorton-mode";

export default function OpenProjectRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <OpenProjectContent />
    </HostRouteBootstrapBoundary>
  );
}

function OpenProjectContent() {
  const hosts = useHosts();
  const isVortonMode = useVortonMode();
  // This URL is also restored directly and reached by Back from Settings.
  // A loaded, empty registry means onboarding, not an empty project dashboard.
  if (isVortonMode && hosts.length === 0) {
    return <Redirect href="/welcome" />;
  }
  return <OpenProjectScreen />;
}
