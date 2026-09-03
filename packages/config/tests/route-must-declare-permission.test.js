import rule from '../src/eslint/rules/route-must-declare-permission.js';
import { makeRuleTester } from './rule-tester.js';

makeRuleTester().run('route-must-declare-permission', rule, {
  valid: [
    // route with a permission
    `@Controller('orders')
     class OrdersController {
       @Get()
       @RequirePermission('orders:view')
       list() {}
     }`,
    // explicitly public route
    `@Controller('health')
     class HealthController {
       @Get('healthz')
       @Public()
       healthz() {}
     }`,
    // non-route method needs nothing
    `@Controller('orders')
     class OrdersController {
       private helper() {}
       @Get() @Public() list() {}
     }`,
    // not a controller — rule does not apply
    `class PlainService {
       @Get() something() {}
     }`,
  ],
  invalid: [
    {
      code: `@Controller('orders')
        class OrdersController {
          @Get()
          list() {}
        }`,
      errors: [{ messageId: 'missing' }],
    },
    {
      code: `@Controller('orders')
        class OrdersController {
          @Post()
          @UseGuards(AuthGuard)
          create() {}

          @Delete(':id')
          remove() {}
        }`,
      errors: [{ messageId: 'missing' }, { messageId: 'missing' }],
    },
  ],
});
