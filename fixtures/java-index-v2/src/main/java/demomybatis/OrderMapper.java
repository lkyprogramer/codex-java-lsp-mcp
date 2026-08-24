package demomybatis;

public interface OrderMapper {
  OrderEntity findById(Long id);

  void insert(OrderEntity order);
}
