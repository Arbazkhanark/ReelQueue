
export const instagramErrors: Record<string, string> = {
  STATE_INVALID:
    "Instagram connection expired or could not be verified. Please try again.",

  ACCESS_DENIED:
    "You denied Instagram access. Please try again if you want to connect.",

  SESSION:
    "Your session has expired. Please log in again.",

  NOT_ENABLED:
    "Instagram integration is currently unavailable.",

  NOT_PROFESSIONAL_ACCOUNT:
    "Instagram returned an unsupported account type. Please check your account type and integration requirements.",

  TOKEN_EXCHANGE_FAILED:
    "Could not authenticate with Instagram. Please try again.",

  PROFILE_FETCH_FAILED:
    "Could not retrieve your Instagram profile.",

  default:
    "Something went wrong while connecting Instagram.",
};
