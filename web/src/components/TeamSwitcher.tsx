import { useEffect } from "react";
import { OrganizationSwitcher, useOrganization, useOrganizationList } from "@clerk/clerk-react";
import { dark as clerkDark } from "@clerk/themes";

/**
 * The team this account's credentials act in. Choosing one makes it the active
 * Clerk organization, and the next API request moves the user's tenant there.
 * Personal is hidden: inside a team, "Mine" already means your private memories.
 * Renders nothing for someone in no team.
 */
export function TeamSwitcher({ dark, teamOrgId }: { dark: boolean; teamOrgId: string | null }) {
  const { organization, isLoaded } = useOrganization();
  const { userMemberships, setActive, isLoaded: listLoaded } = useOrganizationList({ userMemberships: true });

  // A session can start with no active org while the server still acts in a team; show that one.
  useEffect(() => {
    if (!isLoaded || organization || !teamOrgId || !setActive) return;
    void setActive({ organization: teamOrgId }).catch(() => undefined);
  }, [isLoaded, organization, teamOrgId, setActive]);

  if (!listLoaded || (userMemberships?.count ?? 0) === 0) return null;
  return (
    <>
      <span aria-hidden className="text-xl font-light text-border">/</span>
      <OrganizationSwitcher
        hidePersonal
        appearance={{
          baseTheme: dark ? clerkDark : undefined,
          elements: { organizationSwitcherPopoverActionButton__createOrganization: { display: "none" } },
        }}
      />
    </>
  );
}
