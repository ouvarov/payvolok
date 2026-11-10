import { SetMetadata, type CustomDecorator } from '@nestjs/common';

const ROUTE_ACCESS_KEY = 'routeAccess';

type RouteAccess = 'public' | 'api_key';

const RouteAccess = (access: RouteAccess): CustomDecorator<string> =>
  SetMetadata(ROUTE_ACCESS_KEY, access);

export { RouteAccess, ROUTE_ACCESS_KEY };
