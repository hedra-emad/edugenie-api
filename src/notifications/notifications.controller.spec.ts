import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

describe('NotificationsController', () => {
  let controller: NotificationsController;

  const notificationsServiceMock = {
    markAllAsRead: jest.fn(),
    markAsRead: jest.fn(),
    findForUser: jest.fn(),
    getUnreadCount: jest.fn(),
    remove: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        { provide: NotificationsService, useValue: notificationsServiceMock },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<NotificationsController>(NotificationsController);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('markAllAsRead', () => {
    it('marks all of the current user\'s notifications read and wraps the count', async () => {
      notificationsServiceMock.markAllAsRead.mockResolvedValue({
        updatedCount: 3,
      });

      const result = await controller.markAllAsRead({ userId: 'user-1' });

      expect(notificationsServiceMock.markAllAsRead).toHaveBeenCalledWith(
        'user-1',
      );
      expect(result).toEqual({
        success: true,
        data: { updatedCount: 3 },
        message: 'All notifications marked as read',
      });
    });
  });
});
