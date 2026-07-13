import { Test, TestingModule } from '@nestjs/testing';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

describe('CartController', () => {
  let controller: CartController;

  const cartServiceMock = {
    getCart: jest.fn(),
    addToCart: jest.fn(),
    addCourseSmart: jest.fn(),
    removeFromCart: jest.fn(),
    validateCart: jest.fn(),
    clearOwnedItems: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CartController],
      providers: [{ provide: CartService, useValue: cartServiceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<CartController>(CartController);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getCart', () => {
    it('delegates to cartService.getCart with the current user id and wraps the result', async () => {
      const cart = { items: [], total: 0 };
      cartServiceMock.getCart.mockResolvedValue(cart);

      const result = await controller.getCart({ userId: 'student-1' });

      expect(cartServiceMock.getCart).toHaveBeenCalledWith('student-1');
      expect(result).toEqual({
        success: true,
        message: 'Cart retrieved successfully',
        data: cart,
      });
    });
  });
});
