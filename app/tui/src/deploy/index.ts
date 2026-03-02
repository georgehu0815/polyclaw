export type { DeployTarget, TargetType } from "./target.js";
export { LocalDeployTarget, isLocalRunning, readLocalPort, readLocalAdminSecret } from "./local.js";
export { DockerDeployTarget, buildImage, startContainer, stopContainer, getAdminSecret, resolveKvSecret, waitForReady } from "./docker.js";
export { AcaDeployTarget, checkAzCliInstalled, checkAzLoggedIn, getExistingDeployment, removeDeployment } from "./aca.js";
